import json
import os
import secrets
import shutil
import urllib.request
import platform
import zipfile

from GameSentenceMiner.downloader.Untitled_json import scenes
from GameSentenceMiner.configuration import get_app_directory, logger

script_dir = os.path.dirname(os.path.abspath(__file__))

def copy_obs_settings(src, dest):

    if os.path.exists(src):
        user_input = input(f"Existng OBS install located. Do you want to copy OBS settings from {src} to {dest}? (y/n): ").strip().lower() or "y"
        if user_input in ['y', 'yes', '1']:
            logger.info(f"Copying OBS settings from {src} to {dest}...")
            shutil.copytree(src, dest, dirs_exist_ok=True)
            logger.info("OBS settings copied successfully.")
            return True
        else:
            logger.info("Not copying settings!")
            return False
    logger.warning(f"OBS settings directory {src} does not exist. Skipping copy.")
    return False


def download_obs_if_needed():
    obs_path = os.path.join(get_app_directory(), 'obs-studio')
    if os.path.exists(obs_path):
        logger.debug(f"OBS already installed at {obs_path}.")
        return

    os.makedirs(obs_path, exist_ok=True)
    latest_release_url = "https://api.github.com/repos/obsproject/obs-studio/releases/latest"
    with urllib.request.urlopen(latest_release_url) as response:
        latest_release = json.load(response)
        obs_url = {
            "Windows": next(asset['browser_download_url'] for asset in latest_release['assets'] if
                            asset['name'].endswith('Windows.zip')),
            "Linux": next(asset['browser_download_url'] for asset in latest_release['assets'] if
                          asset['name'].endswith('Ubuntu-24.04-x86_64.deb')),
            "Darwin": next(asset['browser_download_url'] for asset in latest_release['assets'] if
                           asset['name'].endswith('macOS-Intel.dmg'))
        }.get(platform.system(), None)

    if obs_url is None:
        logger.error("Unsupported OS. Please install OBS manually.")
        return

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    obs_installer = os.path.join(download_dir, "OBS.zip")

    if os.path.exists(obs_installer):
        logger.debug("OBS installer already exists. Skipping download.")
    else:
        logger.info(f"Downloading OBS from {obs_url}...")
        urllib.request.urlretrieve(obs_url, obs_installer)

    if platform.system() == "Windows":


        logger.info(f"OBS downloaded. Extracting to {obs_path}...")
        with zipfile.ZipFile(obs_installer, 'r') as zip_ref:
            zip_ref.extractall(obs_path)
        open(os.path.join(obs_path, "portable_mode"), 'a').close()
        # websocket_config_path = os.path.join(obs_path, 'config', 'obs-studio')
        # if not copy_obs_settings(os.path.join(os.getenv('APPDATA'), 'obs-studio'), websocket_config_path):
        websocket_config_path = os.path.join(obs_path, 'config', 'obs-studio', 'plugin_config', 'obs-websocket')
        os.makedirs(websocket_config_path, exist_ok=True)

        websocket_config = {
            "alerts_enabled": False,
            "auth_required": False,
            "first_load": False,
            "server_enabled": True,
            "server_password": secrets.token_urlsafe(16),
            "server_port": 7274
        }
        with open(os.path.join(websocket_config_path, 'config.json'), 'w') as config_file:
            json.dump(websocket_config, config_file, indent=4)
        basic_ini_path = os.path.join(obs_path, 'config', 'obs-studio', 'basic', 'profiles', 'Untitled')
        os.makedirs(basic_ini_path, exist_ok=True)
        with open(os.path.join(basic_ini_path, 'basic.ini'), 'w') as basic_ini_file:
            basic_ini_file.write(
                "[SimpleOutput]\n"
                f"FilePath={os.path.expanduser('~')}/Videos/GSM\n"
                "RecRB=true\n"
                "RecRBTime=60\n"
                "RecRBSize=512\n"
                "RecRBPrefix=GSM\n"
                "RecAudioEncoder=opus\n"
            )
        scene_json_path = os.path.join(obs_path, 'config', 'obs-studio', 'basic', 'scenes')
        os.makedirs(scene_json_path, exist_ok=True)
        with open(os.path.join(scene_json_path, 'Untitled.json'), 'w') as scene_file:
            scene_file.write(scenes)
        logger.info(f"OBS extracted to {obs_path}.")
    else:
        logger.error(f"Please install OBS manually from {obs_installer}")

def download_ffmpeg_if_needed():
    ffmpeg_path = os.path.join(get_app_directory(), 'ffmpeg')

    if os.path.exists(ffmpeg_path):
        logger.debug(f"FFmpeg already installed at {ffmpeg_path}.")
        return

    os.makedirs(ffmpeg_path, exist_ok=True)

    ffmpeg_url = {
        "Windows": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        "Linux": "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
        "Darwin": "https://evermeet.cx/ffmpeg/ffmpeg.zip"
    }.get(platform.system(), None)

    if ffmpeg_url is None:
        logger.error("Unsupported OS. Please install FFmpeg manually.")
        return

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    ffmpeg_archive = os.path.join(download_dir, "ffmpeg.zip")

    if os.path.exists(ffmpeg_archive):
        logger.debug("FFmpeg archive already exists. Skipping download.")
    else:
        logger.info(f"Downloading FFmpeg from {ffmpeg_url}...")
        urllib.request.urlretrieve(ffmpeg_url, ffmpeg_archive)
        logger.info(f"FFmpeg downloaded. Extracting to {ffmpeg_path}...")
    with zipfile.ZipFile(ffmpeg_archive, 'r') as zip_ref:
        for member in zip_ref.namelist():
            filename = os.path.basename(member)
            if filename:  # Skip directories
                source = zip_ref.open(member)
                target = open(os.path.join(ffmpeg_path, filename), "wb")
                with source, target:
                    shutil.copyfileobj(source, target)
    logger.info(f"FFmpeg extracted to {ffmpeg_path}.")
def main():
    # Run dependency checks
    download_obs_if_needed()
    download_ffmpeg_if_needed()

if __name__ == "__main__":
    main()
