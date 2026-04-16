import json
import os
import platform
import requests
import secrets
import shutil
import tempfile
import time
import zipfile
from typing import Optional

from GameSentenceMiner.obs import get_obs_path
from GameSentenceMiner.util.communication.electron_ipc import send_install_progress
from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    get_config,
    get_ffmpeg_path,
    logger,
)
from GameSentenceMiner.util.config.configuration import get_ffprobe_path
from GameSentenceMiner.util.downloader.Untitled_json import scenes
from GameSentenceMiner.util.downloader.oneocr_dl import Downloader

script_dir = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_PROGRESS_MIN_INTERVAL_S = 0.25
DOWNLOAD_PROGRESS_MIN_BYTES = 512 * 1024
DOWNLOAD_PROGRESS_MIN_RATIO = 0.01


def report_install_progress(
    stage_id: Optional[str],
    status: str,
    progress_kind: str = "indeterminate",
    progress: Optional[float] = None,
    message: str = "",
    downloaded_bytes: Optional[int] = None,
    total_bytes: Optional[int] = None,
    error: Optional[str] = None,
):
    if not stage_id:
        return
    try:
        send_install_progress(
            stage_id=stage_id,
            status=status,
            progress_kind=progress_kind,
            progress=progress,
            message=message,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            error=error,
        )
    except Exception:
        pass


def should_emit_download_progress(
    downloaded_bytes: int,
    total_bytes: Optional[int],
    last_reported_bytes: int,
    last_reported_at: float,
) -> bool:
    now = time.monotonic()
    if downloaded_bytes <= 0:
        return False
    if total_bytes and downloaded_bytes >= total_bytes:
        return True

    bytes_delta = downloaded_bytes - last_reported_bytes
    ratio_delta = (downloaded_bytes - last_reported_bytes) / total_bytes if total_bytes and total_bytes > 0 else 0
    time_delta = now - last_reported_at
    return (
        bytes_delta >= DOWNLOAD_PROGRESS_MIN_BYTES
        or ratio_delta >= DOWNLOAD_PROGRESS_MIN_RATIO
        or time_delta >= DOWNLOAD_PROGRESS_MIN_INTERVAL_S
    )


def download_file(url, dest_path, chunk_size=8192, stage_id: Optional[str] = None, message: str = "Downloading"):
    """
    Downloads a file from a URL to a destination path using streaming.
    Returns True if successful, False otherwise.
    """
    try:
        logger.info(f"Downloading from {url}...")
        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            total_size = r.headers.get("Content-Length", "unknown")
            total_bytes = int(total_size) if str(total_size).isdigit() else None
            last_reported_bytes = 0
            last_reported_at = 0.0
            with open(dest_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=chunk_size):
                    if chunk:
                        f.write(chunk)
                        downloaded_bytes = f.tell()
                        if should_emit_download_progress(
                            downloaded_bytes,
                            total_bytes,
                            last_reported_bytes,
                            last_reported_at,
                        ):
                            report_install_progress(
                                stage_id,
                                status="running",
                                progress_kind="bytes",
                                progress=(downloaded_bytes / total_bytes) if total_bytes else None,
                                message=message,
                                downloaded_bytes=downloaded_bytes,
                                total_bytes=total_bytes,
                            )
                            last_reported_bytes = downloaded_bytes
                            last_reported_at = time.monotonic()
            if os.path.exists(dest_path):
                final_size = os.path.getsize(dest_path)
                if final_size and final_size != last_reported_bytes:
                    report_install_progress(
                        stage_id,
                        status="running",
                        progress_kind="bytes",
                        progress=(final_size / total_bytes) if total_bytes else None,
                        message=message,
                        downloaded_bytes=final_size,
                        total_bytes=total_bytes,
                    )
        logger.success(f"Download complete: {dest_path}")
        return True
    except Exception as e:
        logger.error(f"Failed to download file from {url}: {e}")
        report_install_progress(
            stage_id,
            status="failed",
            progress_kind="estimated",
            message=f"{message} failed.",
            error=str(e),
        )
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except OSError:
                pass
        return False


def get_json_from_url(url):
    """
    Fetches JSON content from a URL.
    Returns the dictionary or None if failed.
    """
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        logger.error(f"Failed to fetch JSON from {url}: {e}")
        return None


def cleanup_temp_files(func):
    def wrapper(*args, **kwargs):
        temp_files = []

        # Patch tempfile.NamedTemporaryFile to track created temp files
        orig_named_tempfile = tempfile.NamedTemporaryFile

        def tracked_named_tempfile(*a, **kw):
            tmp = orig_named_tempfile(*a, **kw)
            temp_files.append(tmp.name)
            return tmp

        tempfile.NamedTemporaryFile = tracked_named_tempfile

        try:
            result = func(*args, **kwargs)
        finally:
            # Restore original NamedTemporaryFile
            tempfile.NamedTemporaryFile = orig_named_tempfile
            # Remove tracked temp files
            for f in temp_files:
                try:
                    if os.path.exists(f):
                        os.remove(f)
                except Exception:
                    pass
        return result

    return wrapper


def copy_obs_settings(src, dest):

    if os.path.exists(src):
        user_input = (
            input(f"Existing OBS install located. Do you want to copy OBS settings from {src} to {dest}? (y/n): ")
            .strip()
            .lower()
            or "y"
        )
        if user_input in ["y", "yes", "1"]:
            logger.info(f"Copying OBS settings from {src} to {dest}...")
            shutil.copytree(src, dest, dirs_exist_ok=True)
            logger.success("OBS settings copied successfully.")
            return True
        else:
            logger.info("Not copying settings!")
            return False
    logger.warning(f"OBS settings directory {src} does not exist. Skipping copy.")
    return False


def download_scene_switcher_plugin(obs_path, stage_id: Optional[str] = None):
    """Download and install Advanced Scene Switcher plugin for OBS."""
    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)

    # Check if plugin is already installed
    plugin_dll_path = os.path.join(obs_path, "obs-plugins", "64bit", "advanced-scene-switcher.dll")
    if os.path.exists(plugin_dll_path):
        logger.debug("Advanced Scene Switcher plugin already installed.")
        return "skipped"

    logger.info("Downloading Advanced Scene Switcher plugin...")
    scene_switcher_url = "https://api.github.com/repos/WarmUpTill/SceneSwitcher/releases/latest"

    scene_switcher_release = get_json_from_url(scene_switcher_url)

    if scene_switcher_release:
        # Find the Windows x64 asset
        plugin_url = None
        for asset in scene_switcher_release.get("assets", []):
            if "windows-x64.zip" in asset["name"]:
                plugin_url = asset["browser_download_url"]
                break

        if plugin_url:
            scene_switcher_zip = os.path.join(download_dir, "advanced-scene-switcher.zip")
            if download_file(
                plugin_url,
                scene_switcher_zip,
                stage_id=stage_id,
                message="Downloading OBS Scene Switcher plugin...",
            ):
                logger.info(f"Extracting Advanced Scene Switcher to {obs_path}...")
                try:
                    with zipfile.ZipFile(scene_switcher_zip, "r") as zip_ref:
                        zip_ref.extractall(obs_path)
                    logger.success("Advanced Scene Switcher plugin installed successfully.")
                    return "completed"
                except Exception as e:
                    logger.error(f"Failed to extract Advanced Scene Switcher: {e}")
                    raise RuntimeError(f"Failed to extract Advanced Scene Switcher: {e}") from e
                finally:
                    if os.path.exists(scene_switcher_zip):
                        os.unlink(scene_switcher_zip)
        else:
            raise RuntimeError("Could not find Windows x64 version of Advanced Scene Switcher.")
    raise RuntimeError("Failed to install Advanced Scene Switcher plugin.")


def download_obs_if_needed(stage_id: Optional[str] = "obs"):
    obs_path = os.path.join(get_app_directory(), "obs-studio")
    obs_exe_path = get_obs_path()
    if os.path.exists(obs_path) and os.path.exists(obs_exe_path):
        logger.debug(f"OBS already installed at {obs_path}.")
        # Check and install plugin even if OBS is already installed
        plugin_status = download_scene_switcher_plugin(obs_path, stage_id=stage_id)
        return "skipped" if plugin_status == "skipped" else "completed"

    if os.path.exists(obs_path) and not os.path.exists(obs_exe_path):
        logger.info("OBS directory exists but executable is missing. Re-downloading OBS...")
        shutil.rmtree(obs_path)

    latest_release_url = "https://api.github.com/repos/obsproject/obs-studio/releases/latest"
    latest_release = get_json_from_url(latest_release_url)

    if not latest_release:
        raise RuntimeError("Failed to retrieve latest OBS release info.")

    def get_windows_obs_url():
        machine = platform.machine().lower()
        if machine in ["arm64", "aarch64"]:
            logger.info("Detected Windows on ARM64. Getting ARM64 version of OBS Studio.")
            return next(
                (
                    asset["browser_download_url"]
                    for asset in latest_release["assets"]
                    if asset["name"].endswith("Windows-arm64.zip")
                ),
                None,
            )
        return next(
            (
                asset["browser_download_url"]
                for asset in latest_release["assets"]
                if asset["name"].endswith("Windows-x64.zip")
            ),
            None,
        )

    obs_url = {
        "Windows": get_windows_obs_url,
        # "Linux": lambda: ...
        # "Darwin": lambda: ...
    }.get(platform.system(), lambda: None)()

    if obs_url is None:
        raise RuntimeError("Unsupported OS or download URL not found. Please install OBS manually.")

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    obs_installer = os.path.join(download_dir, "OBS.zip")

    if download_file(obs_url, obs_installer, stage_id=stage_id, message="Downloading OBS Studio..."):
        os.makedirs(obs_path, exist_ok=True)

        if platform.system() == "Windows":
            logger.info(f"OBS downloaded. Extracting to {obs_path}...")
            try:
                with zipfile.ZipFile(obs_installer, "r") as zip_ref:
                    zip_ref.extractall(obs_path)
                open(os.path.join(obs_path, "portable_mode"), "a").close()
                write_obs_configs(obs_path)
                logger.success(f"OBS extracted to {obs_path}.")

                # Download and install Advanced Scene Switcher plugin
                download_scene_switcher_plugin(obs_path, stage_id=stage_id)
                return "completed"
            except Exception as e:
                logger.error(f"Failed to extract OBS: {e}")
                raise RuntimeError(f"Failed to extract OBS: {e}") from e
            finally:
                if os.path.exists(obs_installer):
                    os.unlink(obs_installer)
        else:
            raise RuntimeError(f"Please install OBS manually from {obs_installer}")
    raise RuntimeError("Failed to download OBS Studio.")


def write_websocket_configs(obs_path):
    websocket_config_path = os.path.join(obs_path, "config", "obs-studio", "plugin_config", "obs-websocket")
    os.makedirs(websocket_config_path, exist_ok=True)
    obs_config = get_config().obs

    existing_config = None
    if os.path.exists(os.path.join(websocket_config_path, "config.json")):
        with open(os.path.join(websocket_config_path, "config.json"), "r") as existing_config_file:
            try:
                existing_config = json.load(existing_config_file)
                if obs_config.port != existing_config.get("server_port", 7274):
                    logger.info(
                        f"OBS WebSocket port changed from {existing_config.get('server_port', 7274)} to {obs_config.port}. Updating config."
                    )
                    existing_config["server_port"] = obs_config.port
                    existing_config["server_password"] = obs_config.password
                    existing_config["auth_required"] = False
                    existing_config["server_enabled"] = True
                    with open(os.path.join(websocket_config_path, "config.json"), "w") as config_file:
                        json.dump(existing_config, config_file, indent=4)
            except json.JSONDecodeError:
                existing_config = None
    if not existing_config:
        websocket_config = {
            "alerts_enabled": False,
            "auth_required": False,
            "first_load": False,
            "server_enabled": True,
            "server_password": secrets.token_urlsafe(16),
            "server_port": obs_config.port,
        }
        with open(os.path.join(websocket_config_path, "config.json"), "w") as config_file:
            json.dump(websocket_config, config_file, indent=4)


def write_replay_buffer_configs(obs_path):
    basic_ini_path = os.path.join(obs_path, "config", "obs-studio", "basic", "profiles", "GSM")
    if os.path.exists(os.path.join(basic_ini_path, "basic.ini")):
        return
    os.makedirs(basic_ini_path, exist_ok=True)
    with open(os.path.join(basic_ini_path, "basic.ini"), "w") as basic_ini_file:
        basic_ini_file.write(
            "[SimpleOutput]\n"
            f"FilePath={os.path.expanduser('~')}/Videos/GSM\n"
            "RecRB=true\n"
            "RecRBTime=300\n"
            "RecRBSize=512\n"
            "RecAudioEncoder=opus\n"
            "RecRBPrefix=GSM\n"
        )

    basic_ini_path = os.path.join(obs_path, "config", "obs-studio", "basic", "profiles", "Untitled")
    if os.path.exists(os.path.join(basic_ini_path, "basic.ini")):
        return
    os.makedirs(basic_ini_path, exist_ok=True)
    with open(os.path.join(basic_ini_path, "basic.ini"), "w") as basic_ini_file:
        basic_ini_file.write(
            "[SimpleOutput]\n"
            f"FilePath={os.path.expanduser('~')}/Videos/GSM\n"
            "RecRB=true\n"
            "RecRBTime=300\n"
            "RecRBSize=512\n"
            "RecAudioEncoder=opus\n"
            "RecRBPrefix=GSM\n"
        )


def write_default_scene_configs(obs_path):
    """Write default scene configurations for common scene collection names."""
    scene_json_path = os.path.join(obs_path, "config", "obs-studio", "basic", "scenes")
    os.makedirs(scene_json_path, exist_ok=True)

    # List of common default scene collection names
    default_scene_names = [
        "Untitled.json",  # English default
        # '無題.json',       # Japanese default (Mudai - Untitled)
        # 'Sin título.json', # Spanish default
        # '未命名.json',     # Chinese default (Weimingming - Unnamed)
        # 'Sem título.json', # Portuguese default
        # 'Sans titre.json', # French default
        # 'Без названия.json', # Russian default
    ]

    for scene_name in default_scene_names:
        scene_file_path = os.path.join(scene_json_path, scene_name)
        if not os.path.exists(scene_file_path):
            with open(scene_file_path, "w", encoding="utf-8") as scene_file:
                scene_file.write(scenes)
            logger.debug(f"Created default scene config: {scene_name}")


def write_obs_configs(obs_path):
    write_websocket_configs(obs_path)
    write_replay_buffer_configs(obs_path)
    write_default_scene_configs(obs_path)


def download_ffmpeg_if_needed(stage_id: Optional[str] = "ffmpeg"):
    ffmpeg_dir = os.path.join(get_app_directory(), "ffmpeg")
    ffmpeg_exe_path = get_ffmpeg_path()
    ffprobe_exe_path = get_ffprobe_path()

    if os.path.exists(ffmpeg_dir) and os.path.exists(ffmpeg_exe_path) and os.path.exists(ffprobe_exe_path):
        logger.debug(f"FFmpeg already installed at {ffmpeg_dir}.")
        return "skipped"

    if os.path.exists(ffmpeg_dir) and (not os.path.exists(ffmpeg_exe_path) or not os.path.exists(ffprobe_exe_path)):
        logger.info("FFmpeg directory exists but executables are missing. Re-downloading FFmpeg...")
        shutil.rmtree(ffmpeg_dir)

    system = platform.system()
    ffmpeg_url = None
    compressed_format = "zip"
    if system == "Windows":
        machine = platform.machine().lower()
        if machine in ["arm64", "aarch64"]:
            ffmpeg_url = "https://gsm.beangate.us/ffmpeg-8.0-essentials-shared-win-arm64.zip"
            compressed_format = "zip"
        else:
            ffmpeg_url = (
                "https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip"
            )
            compressed_format = "zip"
    # elif system == "Linux":
    #     ffmpeg_url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    # elif system == "Darwin":
    #     ffmpeg_url = "https://evermeet.cx/ffmpeg/ffmpeg.zip"

    if ffmpeg_url is None:
        raise RuntimeError("Unsupported OS/architecture. Please install FFmpeg manually.")

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    ffmpeg_archive = os.path.join(download_dir, f"ffmpeg.{compressed_format}")

    if download_file(ffmpeg_url, ffmpeg_archive, stage_id=stage_id, message="Downloading FFmpeg..."):
        logger.info(f"FFmpeg downloaded. Extracting to {ffmpeg_dir}...")

        os.makedirs(ffmpeg_dir, exist_ok=True)

        # Extract archive
        try:
            if ffmpeg_url.endswith(".7z"):
                import py7zr

                with py7zr.SevenZipFile(ffmpeg_archive, mode="r") as z:
                    z.extractall(ffmpeg_dir)
            else:
                with zipfile.ZipFile(ffmpeg_archive, "r") as zip_ref:
                    zip_ref.extractall(ffmpeg_dir)

            # Flatten directory structure - move all files to root ffmpeg_dir
            def flatten_directory(directory):
                for root, dirs, files in os.walk(directory):
                    for file in files:
                        file_path = os.path.join(root, file)
                        if root != directory:  # Only move files from subdirectories
                            target_path = os.path.join(directory, file)
                            # Handle name conflicts by keeping the first occurrence
                            if not os.path.exists(target_path):
                                shutil.move(file_path, target_path)
                # Remove empty subdirectories
                for root, dirs, files in os.walk(directory, topdown=False):
                    for dir_name in dirs:
                        dir_path = os.path.join(root, dir_name)
                        try:
                            os.rmdir(dir_path)
                        except OSError:
                            pass  # Directory not empty

            flatten_directory(ffmpeg_dir)
            logger.success(f"FFmpeg extracted to {ffmpeg_dir}.")
            return "completed"
        except Exception as e:
            logger.error(f"Failed to extract FFmpeg: {e}")
            raise RuntimeError(f"Failed to extract FFmpeg: {e}") from e
        finally:
            if os.path.exists(ffmpeg_archive):
                os.unlink(ffmpeg_archive)
                logger.debug(f"Removed FFmpeg archive: {ffmpeg_archive}")
    raise RuntimeError("Failed to download FFmpeg.")


def download_ocenaudio_if_needed():
    ocenaudio_dir = os.path.join(get_app_directory(), "ocenaudio")
    ocenaudio_exe_path = os.path.join(ocenaudio_dir, "ocenaudio.exe")
    if os.path.exists(ocenaudio_dir) and os.path.exists(ocenaudio_exe_path):
        logger.info(f"Ocenaudio already installed at {ocenaudio_dir}.")
        return ocenaudio_exe_path

    if os.path.exists(ocenaudio_dir) and not os.path.exists(ocenaudio_exe_path):
        logger.info("Ocenaudio directory exists but executable is missing. Re-downloading Ocenaudio...")
        shutil.rmtree(ocenaudio_dir)

    ocenaudio_url = "https://www.ocenaudio.com/downloads/ocenaudio_windows64.zip"

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    ocenaudio_archive = os.path.join(download_dir, "ocenaudio.zip")

    if download_file(ocenaudio_url, ocenaudio_archive):
        logger.info(f"Ocenaudio downloaded. Extracting to {ocenaudio_dir}...")

        try:
            os.makedirs(ocenaudio_dir, exist_ok=True)
            with zipfile.ZipFile(ocenaudio_archive, "r") as zip_ref:
                zip_ref.extractall(get_app_directory())
            logger.success(f"Ocenaudio extracted to {ocenaudio_dir}.")
        except Exception as e:
            logger.error(f"Failed to extract Ocenaudio: {e}")

    return ocenaudio_exe_path


def download_oneocr_dlls_if_needed(stage_id: Optional[str] = "oneocr"):
    downloader = Downloader()
    return downloader.download_and_extract(stage_id=stage_id)


def main():
    download_obs_if_needed()
    download_ffmpeg_if_needed()
    download_ocenaudio_if_needed()
    download_oneocr_dlls_if_needed()


if __name__ == "__main__":
    main()
